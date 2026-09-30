// One document, one Durable Object, one effective Workers Cache key, one client.
// -1 represents an absent cache entry or an absent in-flight GET response.
module sync {
  var doVersion: int
  var cacheVersion: int
  var inflightGet: int
  var writePhase: int // 0: idle, 1: purge pending, 2: acknowledgement pending
  var clientVersion: int
  var maxSeen: int

  action init = all {
    doVersion' = 0,
    cacheVersion' = 0,
    inflightGet' = -1,
    writePhase' = 0,
    clientVersion' = 0,
    maxSeen' = 0,
  }

  // The cache can hand out an old response that stays in flight after purge.
  action startGet = all {
    inflightGet == -1,
    inflightGet' = if (cacheVersion == -1) doVersion else cacheVersion,
    cacheVersion' = if (cacheVersion == -1) doVersion else cacheVersion,
    doVersion' = doVersion,
    writePhase' = writePhase,
    clientVersion' = clientVersion,
    maxSeen' = maxSeen,
  }

  // The Durable Object serializes writes and assigns a new revision.
  action commitWrite = all {
    writePhase == 0,
    doVersion < 2,
    doVersion' = doVersion + 1,
    writePhase' = 1,
    cacheVersion' = cacheVersion,
    inflightGet' = inflightGet,
    clientVersion' = clientVersion,
    maxSeen' = maxSeen,
  }

  // Model a successful purge. This prevents future hits but cannot recall a response.
  action purge = all {
    writePhase == 1,
    cacheVersion' = -1,
    writePhase' = 2,
    doVersion' = doVersion,
    inflightGet' = inflightGet,
    clientVersion' = clientVersion,
    maxSeen' = maxSeen,
  }

  // A failed purge leaves future cache hits stale; the client still must not regress.
  action purgeFailed = all {
    writePhase == 1,
    cacheVersion' = cacheVersion,
    writePhase' = 2,
    doVersion' = doVersion,
    inflightGet' = inflightGet,
    clientVersion' = clientVersion,
    maxSeen' = maxSeen,
  }

  action acknowledgeWrite = all {
    writePhase == 2,
    clientVersion' = doVersion,
    maxSeen' = if (doVersion > maxSeen) doVersion else maxSeen,
    writePhase' = 0,
    doVersion' = doVersion,
    cacheVersion' = cacheVersion,
    inflightGet' = inflightGet,
  }

  // Bug: an old GET overwrites the newer write acknowledgement.
  action deliverGetNaive = all {
    inflightGet >= 0,
    clientVersion' = inflightGet,
    maxSeen' = if (inflightGet > maxSeen) inflightGet else maxSeen,
    inflightGet' = -1,
    doVersion' = doVersion,
    cacheVersion' = cacheVersion,
    writePhase' = writePhase,
  }

  // Repair: ignore responses older than the newest revision seen by this client.
  action deliverGetSafe = all {
    inflightGet >= 0,
    clientVersion' = if (inflightGet >= clientVersion) inflightGet else clientVersion,
    maxSeen' = if (inflightGet > maxSeen) inflightGet else maxSeen,
    inflightGet' = -1,
    doVersion' = doVersion,
    cacheVersion' = cacheVersion,
    writePhase' = writePhase,
  }

  action stepNaive = any {
    startGet,
    commitWrite,
    purge,
    purgeFailed,
    acknowledgeWrite,
    deliverGetNaive,
  }

  action stepSafe = any {
    startGet,
    commitWrite,
    purge,
    purgeFailed,
    acknowledgeWrite,
    deliverGetSafe,
  }

  val monotonicClient = clientVersion == maxSeen
  val cacheNeverAhead = cacheVersion <= doVersion
  val serverAdvanced = doVersion > 0
}
