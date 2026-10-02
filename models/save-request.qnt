// One operation ID, two attempts, and a lost response after commit.
// A receipt must commit atomically with the document and its outbox event.
// Receipts do not expire in this bounded demonstration.
module saveRequest {
  var version: int
  var outbox: Set[int]
  var receipt: int
  var phase: int // 0: idle, 1: received, 2: committed, 3: responded, 4: lost
  var attempts: int
  var responseVersion: int
  var lost: bool

  action init = all { version' = 0, outbox' = Set(), receipt' = 0,
    phase' = 0, attempts' = 0, responseVersion' = 0, lost' = false }
  action receive = all {
    (phase == 0 or phase == 4), attempts < 2,
    phase' = 1, attempts' = attempts + 1, version' = version,
    outbox' = outbox, receipt' = receipt, responseVersion' = responseVersion, lost' = lost,
  }
  action commit(safe: bool): bool = all {
    phase == 1,
    version' = if (safe and receipt > 0) version else version + 1,
    outbox' = if (safe and receipt > 0) outbox else outbox.union(Set(version + 1)),
    receipt' = if (safe and receipt == 0) version + 1 else receipt,
    responseVersion' = if (safe and receipt > 0) receipt else version + 1,
    phase' = 2, attempts' = attempts, lost' = lost,
  }
  action commitNaive = commit(false)
  action commitSafe = commit(true)
  // Buggy receipt persistence is a second transaction: a crash can precede it.
  action remember = all {
    phase == 2, receipt == 0, receipt' = version, version' = version,
    outbox' = outbox, phase' = phase, attempts' = attempts,
    responseVersion' = responseVersion, lost' = lost,
  }
  action loseResponse = all {
    phase == 2, lost == false, phase' = 4, lost' = true,
    version' = version, outbox' = outbox, receipt' = receipt,
    attempts' = attempts, responseVersion' = responseVersion,
  }
  action respond = all {
    phase == 2, phase' = 3, version' = version, outbox' = outbox,
    receipt' = receipt, attempts' = attempts,
    responseVersion' = responseVersion, lost' = lost,
  }
  action stepNaive = any { receive, commitNaive, remember, loseResponse, respond }
  action stepSafe = any { receive, commitSafe, loseResponse, respond }
  val oneOperationOneUpdate = version <= 1 and outbox.size() <= 1
  val receiptMatchesCommit = version == receipt
  val stableResponse = phase != 3 or responseVersion == receipt
  val noRetriedResponse = not(lost and attempts == 2 and phase == 3 and responseVersion == 1)
}
