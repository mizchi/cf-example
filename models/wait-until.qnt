// One HTTP request and one task registered with ctx.waitUntil().
// Status 0: new, 1: running, 2: effect completed, 3: failed before the effect.
// The application contract is: an accepted job must not end lost.
module waitUntil {
  var accepted: bool
  var status: int

  action init = all {
    accepted' = false,
    status' = 0,
  }

  action start = all {
    status == 0,
    status' = 1,
    accepted' = accepted,
  }

  // Bug: HTTP 202 is returned before the task settles.
  action respondNaive = all {
    status == 1,
    accepted == false,
    accepted' = true,
    status' = status,
  }

  action complete = all {
    status == 1,
    status' = 2,
    accepted' = accepted,
  }

  // The task ends before its observable effect; no retry is modeled.
  action cancelOrReject = all {
    status == 1,
    accepted == true,
    status' = 3,
    accepted' = accepted,
  }

  // A failure before the response can instead produce a non-2xx result.
  action failBeforeResponse = all {
    status == 1,
    accepted == false,
    status' = 3,
    accepted' = accepted,
  }

  // Repair for this contract: await completion before acknowledging.
  action respondSafe = all {
    status == 2,
    accepted == false,
    accepted' = true,
    status' = status,
  }

  action stepNaive = any { start, respondNaive, complete, cancelOrReject, failBeforeResponse }
  action stepSafe = any { start, complete, cancelOrReject, failBeforeResponse, respondSafe }

  val noLostAccepted = not(accepted and status == 3)
  // Negated reachability check: the safe path must still accept completed work.
  val noCompletedAccepted = not(accepted and status == 2)
}
