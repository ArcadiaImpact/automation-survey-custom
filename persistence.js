(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SurveyPersistence = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const DRAFT_TTL_MS = 48 * 60 * 60 * 1000;

  function isDraftExpired(draft, nowMs) {
    return (
      !draft ||
      !Number.isFinite(draft.local_updated_at) ||
      nowMs - draft.local_updated_at >= DRAFT_TTL_MS
    );
  }

  function draftEnvelope(snapshot) {
    const copy = JSON.parse(JSON.stringify(snapshot));
    delete copy.local_updated_at;
    if (copy.answers) delete copy.answers.email;
    copy.status = "draft";
    return copy;
  }

  function createAutosaveCoordinator(options) {
    let pending = null;
    let finalJob = null;
    let inFlight = false;
    let current = null;
    let timer = null;
    let stopped = false;
    let lastStartedAt = -Infinity;
    let retryIndex = 0;
    const retryDelays = options.retryDelays || [2000, 5000, 15000];

    function emit(state) {
      options.onState(state);
    }

    function permanentError(message, code) {
      const error = new Error(message);
      error.code = code;
      error.retryable = false;
      return error;
    }

    function cancelTimer() {
      if (timer !== null) options.clearTimer(timer);
      timer = null;
    }

    function schedule(waitOverride) {
      if (
        stopped ||
        inFlight ||
        (!pending && !finalJob) ||
        timer !== null
      ) {
        return;
      }
      const wait =
        waitOverride === undefined
          ? Math.max(
              options.debounceMs,
              options.minIntervalMs - (options.now() - lastStartedAt)
            )
          : waitOverride;
      timer = options.setTimer(() => {
        timer = null;
        flush();
      }, Math.max(0, wait));
    }

    async function flush() {
      if (stopped || inFlight || (!pending && !finalJob)) return;
      cancelTimer();
      const job = finalJob || { snapshot: pending, kind: "draft" };
      let retryWait;
      if (job.kind === "draft") pending = null;
      job.controller =
        typeof AbortController === "function" ? new AbortController() : null;
      current = job;
      inFlight = true;
      lastStartedAt = options.now();
      emit("saving");

      try {
        const ack = await options.send(
          job.snapshot,
          job.controller ? job.controller.signal : undefined
        );
        if (!ack || !ack.ok) {
          const error = new Error((ack && ack.message) || "save failed");
          error.code = ack && ack.code;
          error.retryable = !ack || ack.code === "server_error";
          throw error;
        }
        if (
          job.kind === "final" &&
          (ack.status !== "submitted" ||
            ack.accepted_revision !== job.snapshot.revision)
        ) {
          throw permanentError(
            "Server did not confirm submitted revision " +
              job.snapshot.revision +
              ".",
            "revision_mismatch"
          );
        }
        emit("saved");
        retryIndex = 0;
        if (job.kind === "final") {
          finalJob = null;
          stopped = true;
          job.resolve(ack);
        } else if (ack.status === "submitted" && !finalJob) {
          pending = null;
          stopped = true;
        }
      } catch (error) {
        if (!job.cancelled) {
          emit(error.retryable === false ? "failed" : "offline");
        }
        if (job.kind === "final") {
          finalJob = null;
          job.reject(error);
        } else if (error.retryable === false) {
          if (!pending || pending.revision <= job.snapshot.revision) {
            pending = null;
          }
        } else if (!finalJob) {
          if (!pending || pending.revision < job.snapshot.revision) {
            pending = job.snapshot;
          }
          retryWait =
            retryDelays[Math.min(retryIndex, retryDelays.length - 1)];
          retryIndex++;
        }
      } finally {
        current = null;
        inFlight = false;
        if (finalJob) schedule(0);
        else if (pending && timer === null) schedule(retryWait);
      }
    }

    return {
      queue(snapshot) {
        if (stopped || finalJob) return;
        pending = snapshot;
        retryIndex = 0;
        if (!inFlight) cancelTimer();
        schedule();
      },
      flush,
      retry() {
        if (stopped || finalJob || !pending) return;
        cancelTimer();
        schedule(0);
      },
      submit(snapshot) {
        if (stopped) {
          return Promise.reject(new Error("coordinator stopped"));
        }
        if (finalJob) {
          return Promise.reject(new Error("final submission already queued"));
        }
        pending = null;
        cancelTimer();
        if (current && current.kind === "draft") {
          // Do not wait behind a background draft: abandon it and send the
          // final answers now. The server orders writes by revision, so a
          // draft that still lands cannot overwrite the final.
          current.cancelled = true;
          if (current.controller) current.controller.abort();
        }
        return new Promise((resolve, reject) => {
          finalJob = { snapshot, kind: "final", resolve, reject };
          if (!inFlight) schedule(0);
        });
      },
      dispose() {
        stopped = true;
        pending = null;
        finalJob = null;
        cancelTimer();
      },
    };
  }

  return {
    DRAFT_TTL_MS,
    isDraftExpired,
    draftEnvelope,
    createAutosaveCoordinator,
  };
});
