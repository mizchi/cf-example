// One document, versions 1..3, one expiry, search and audit checkpoints.
// Recovery subscribes at latest BEFORE reading the authoritative snapshot.
// Snapshot reads and subscription creation are individually atomic; no
// cross-service transaction or unbounded eventual-completion claim.
module retentionRecovery {
  var source: int
  var retained: Set[int]
  var expiredThrough: int
  var cursor: int
  var search: int
  var phase: int // 0: idle, 1: first recovery step, 2: second step, 3: committed
  var snapshot: int
  var subscriptionStart: int
  var caughtUp: bool
  var auditCursor: int
  var auditSeen: Set[int]
  var auditComplete: bool

  action init = all {
    source' = 0, retained' = Set(), expiredThrough' = 0, cursor' = 0, search' = 0,
    phase' = 0, snapshot' = 0, subscriptionStart' = 0, caughtUp' = false,
    auditCursor' = 0, auditSeen' = Set(), auditComplete' = true,
  }
  action holdAudit = all { auditCursor' = auditCursor, auditSeen' = auditSeen, auditComplete' = auditComplete }
  action holdRecovery = all { cursor' = cursor, search' = search, phase' = phase,
    snapshot' = snapshot, subscriptionStart' = subscriptionStart, caughtUp' = caughtUp }
  action produce = all {
    source < 3, source' = source + 1, retained' = retained.union(Set(source + 1)),
    expiredThrough' = expiredThrough, cursor' = cursor, search' = search,
    phase' = phase, snapshot' = snapshot, subscriptionStart' = subscriptionStart,
    caughtUp' = false, holdAudit,
  }
  action expire = all {
    source > 0, expiredThrough == 0, phase == 0,
    source' = source, retained' = Set(), expiredThrough' = source,
    holdRecovery, holdAudit,
  }
  action begin(safe: bool): bool = all {
    phase == 0, cursor < expiredThrough, phase' = 1,
    subscriptionStart' = if (safe) source else 0,
    snapshot' = if (safe) 0 else source,
    source' = source, retained' = retained, expiredThrough' = expiredThrough,
    cursor' = cursor, search' = search, caughtUp' = false, holdAudit,
  }
  action beginSafe = begin(true)
  action beginNaive = begin(false)
  action second(safe: bool): bool = all {
    phase == 1, phase' = 2,
    snapshot' = if (safe) source else snapshot,
    subscriptionStart' = if (safe) subscriptionStart else source,
    source' = source, retained' = retained, expiredThrough' = expiredThrough,
    cursor' = cursor, search' = search, caughtUp' = caughtUp, holdAudit,
  }
  action secondSafe = second(true)
  action secondNaive = second(false)
  action commit = all {
    phase == 2, phase' = 3,
    search' = if (snapshot > search) snapshot else search,
    cursor' = subscriptionStart, snapshot' = snapshot, subscriptionStart' = subscriptionStart,
    source' = source, retained' = retained, expiredThrough' = expiredThrough,
    caughtUp' = false, holdAudit,
  }
  action consumeSearch = all {
    phase.in(Set(0, 3)), (cursor + 1).in(retained),
    cursor' = cursor + 1, search' = if (cursor + 1 > search) cursor + 1 else search,
    source' = source, retained' = retained, expiredThrough' = expiredThrough,
    phase' = phase, snapshot' = snapshot, subscriptionStart' = subscriptionStart,
    caughtUp' = false, holdAudit,
  }
  action settle = all {
    cursor == source, not(caughtUp), caughtUp' = true,
    source' = source, retained' = retained, expiredThrough' = expiredThrough,
    cursor' = cursor, search' = search, phase' = phase,
    snapshot' = snapshot, subscriptionStart' = subscriptionStart, holdAudit,
  }
  action resumeAudit(safe: bool): bool = all {
    auditCursor < expiredThrough,
    auditCursor' = expiredThrough, auditSeen' = auditSeen,
    auditComplete' = if (safe) false else auditComplete,
    source' = source, retained' = retained, expiredThrough' = expiredThrough, holdRecovery,
  }
  action resumeAuditSafe = resumeAudit(true)
  action resumeAuditNaive = resumeAudit(false)
  action consumeAudit = all {
    (auditCursor + 1).in(retained),
    auditSeen' = auditSeen.union(Set(auditCursor + 1)), auditCursor' = auditCursor + 1,
    auditComplete' = auditComplete,
    source' = source, retained' = retained, expiredThrough' = expiredThrough, holdRecovery,
  }
  action stepNaive = any { produce, expire, beginNaive, secondNaive, commit, consumeSearch, settle, resumeAuditSafe, consumeAudit }
  action stepAuditNaive = any { produce, expire, beginSafe, secondSafe, commit, consumeSearch, settle, resumeAuditNaive, consumeAudit }
  action stepSafe = any { produce, expire, beginSafe, secondSafe, commit, consumeSearch, settle, resumeAuditSafe, consumeAudit }
  val noFalseCaughtUp = not(caughtUp) or search == source
  val noSilentAuditSkip = auditCursor < expiredThrough or not(auditComplete) or
    Set(1, 2, 3).forall(version => version > expiredThrough or version.in(auditSeen))
  val projectionsNeverAhead = search <= source and auditSeen.forall(version => version <= source)
  val noRecoveredWithConcurrentWrite = not(phase == 3 and caughtUp and source == 3 and
    subscriptionStart == 2 and snapshot == 3 and search == 3 and not(auditComplete))
}
