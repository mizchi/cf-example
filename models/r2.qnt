// One R2 object and two clients that read its ETag before writing.
module r2 {
  var etag: int
  var observedA: int // 0 not read, -1 done
  var observedB: int
  var staleAccepted: bool

  action init = all {
    etag' = 1,
    observedA' = 0,
    observedB' = 0,
    staleAccepted' = false,
  }

  action readA = all {
    observedA == 0,
    observedA' = etag,
    observedB' = observedB,
    etag' = etag,
    staleAccepted' = staleAccepted,
  }
  action readB = all {
    observedB == 0,
    observedB' = etag,
    observedA' = observedA,
    etag' = etag,
    staleAccepted' = staleAccepted,
  }

  // Bug: unconditional put can overwrite a newer object.
  action putNaiveA = all {
    observedA > 0,
    etag' = etag + 1,
    observedA' = -1,
    observedB' = observedB,
    staleAccepted' = if (observedA != etag) true else staleAccepted,
  }
  action putNaiveB = all {
    observedB > 0,
    etag' = etag + 1,
    observedB' = -1,
    observedA' = observedA,
    staleAccepted' = if (observedB != etag) true else staleAccepted,
  }

  // onlyIf: { etagMatches: observed } makes the check and put one operation.
  action putIfMatchA = all {
    observedA > 0,
    observedA == etag,
    etag' = etag + 1,
    observedA' = -1,
    observedB' = observedB,
    staleAccepted' = staleAccepted,
  }
  action putIfMatchB = all {
    observedB > 0,
    observedB == etag,
    etag' = etag + 1,
    observedB' = -1,
    observedA' = observedA,
    staleAccepted' = staleAccepted,
  }
  action rejectA = all {
    observedA > 0,
    observedA != etag,
    observedA' = -1,
    observedB' = observedB,
    etag' = etag,
    staleAccepted' = staleAccepted,
  }
  action rejectB = all {
    observedB > 0,
    observedB != etag,
    observedB' = -1,
    observedA' = observedA,
    etag' = etag,
    staleAccepted' = staleAccepted,
  }

  action stepNaive = any { readA, readB, putNaiveA, putNaiveB }
  action stepSafe = any { readA, readB, putIfMatchA, putIfMatchB, rejectA, rejectB }

  val noStaleOverwrite = staleAccepted == false
}
