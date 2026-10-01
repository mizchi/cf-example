// Application layer: one document, two saved versions, bounded duplicate
// publication/delivery, a durable outbox, and independent search/audit sinks.
// K2 leases and batch ack are checked separately in k2.qnt.
module documentEvents {
  pure val Versions = Set(1, 2)
  var documentVersion: int
  var outbox: Set[int]
  var volatileEvents: Set[int]
  var copies: int -> int
  var publishing: int
  var searchVersion: int
  var maxSeen: int
  var searchDeliveries: int -> int
  var auditSeen: Set[int]
  var auditEffects: int -> int
  var auditCount: int
  var auditDeliveries: int -> int

  action init = all {
    documentVersion' = 0,
    outbox' = Set(),
    volatileEvents' = Set(),
    copies' = Map(1 -> 0, 2 -> 0),
    publishing' = 0,
    searchVersion' = 0,
    maxSeen' = 0,
    searchDeliveries' = Map(1 -> 0, 2 -> 0),
    auditSeen' = Set(),
    auditEffects' = Map(1 -> 0, 2 -> 0),
    auditCount' = 0,
    auditDeliveries' = Map(1 -> 0, 2 -> 0),
  }
  action holdSinks = all {
    searchVersion' = searchVersion,
    maxSeen' = maxSeen,
    searchDeliveries' = searchDeliveries,
    auditSeen' = auditSeen,
    auditEffects' = auditEffects,
    auditCount' = auditCount,
    auditDeliveries' = auditDeliveries,
  }
  action holdSource = all {
    documentVersion' = documentVersion,
    outbox' = outbox,
    volatileEvents' = volatileEvents,
    copies' = copies,
    publishing' = publishing,
  }

  action save(safe: bool): bool = all {
    documentVersion < 2,
    documentVersion' = documentVersion + 1,
    outbox' = if (safe) outbox.union(Set(documentVersion + 1)) else outbox,
    volatileEvents' = if (safe) volatileEvents else volatileEvents.union(Set(documentVersion + 1)),
    copies' = copies,
    publishing' = publishing,
    holdSinks,
  }
  action saveNaive = save(false)
  action saveSafe = save(true)

  action publish = {
    nondet version = Versions.oneOf()
    all {
      publishing == 0,
      version.in(outbox.union(volatileEvents)),
      copies.get(version) < 2,
      copies' = copies.set(version, copies.get(version) + 1),
      publishing' = version,
      documentVersion' = documentVersion,
      outbox' = outbox,
      volatileEvents' = volatileEvents,
      holdSinks,
    }
  }
  action confirm = all {
    publishing > 0,
    outbox' = outbox.exclude(Set(publishing)),
    volatileEvents' = volatileEvents.exclude(Set(publishing)),
    publishing' = 0,
    documentVersion' = documentVersion,
    copies' = copies,
    holdSinks,
  }
  // Lost append responses retain the outbox; an unsafe memory-only event
  // disappears if failure happens between the save and publication.
  action crash = all {
    volatileEvents.size() > 0 or publishing > 0,
    volatileEvents' = Set(),
    publishing' = 0,
    documentVersion' = documentVersion,
    outbox' = outbox,
    copies' = copies,
    holdSinks,
  }
  action search(safe: bool): bool = {
    nondet version = Versions.oneOf()
    all {
      copies.get(version) > 0,
      searchDeliveries.get(version) < 2,
      holdSource,
      searchVersion' = if (safe and searchVersion > version) searchVersion else version,
      maxSeen' = if (maxSeen > version) maxSeen else version,
      searchDeliveries' = searchDeliveries.set(version, searchDeliveries.get(version) + 1),
      auditSeen' = auditSeen,
      auditEffects' = auditEffects,
      auditCount' = auditCount,
      auditDeliveries' = auditDeliveries,
    }
  }
  action searchNaive = search(false)
  action searchSafe = search(true)
  action audit(safe: bool): bool = {
    nondet version = Versions.oneOf()
    val delta = if (safe and version.in(auditSeen)) 0 else 1
    all {
      copies.get(version) > 0,
      auditDeliveries.get(version) < 2,
      holdSource,
      searchVersion' = searchVersion,
      maxSeen' = maxSeen,
      searchDeliveries' = searchDeliveries,
      auditSeen' = auditSeen.union(Set(version)),
      auditEffects' = auditEffects.set(version, auditEffects.get(version) + delta),
      auditCount' = auditCount + delta,
      auditDeliveries' = auditDeliveries.set(version, auditDeliveries.get(version) + 1),
    }
  }
  action auditNaive = audit(false)
  action auditSafe = audit(true)

  action stepNaive = any { saveNaive, publish, confirm, crash, searchSafe, auditSafe }
  action stepStale = any { saveSafe, publish, confirm, crash, searchNaive, auditSafe }
  action stepDuplicate = any { saveSafe, publish, confirm, crash, searchSafe, auditNaive }
  action stepSafe = any { saveSafe, publish, confirm, crash, searchSafe, auditSafe }

  val noLostSaved = Versions.forall(version => version > documentVersion or
    version.in(outbox.union(volatileEvents)) or copies.get(version) > 0)
  val monotonicSearch = searchVersion == maxSeen
  val atMostOneAudit = Versions.forall(version => auditEffects.get(version) <= 1)
  val readModelsNeverAhead = searchVersion <= documentVersion and auditSeen.forall(version => version <= documentVersion)
  val auditConsistent = auditCount == auditEffects.get(1) + auditEffects.get(2)
  val noCaughtUp = not(documentVersion == 2 and outbox.size() == 0 and searchVersion == 2 and auditCount == 2)
  val noRetriedPublicationCompletes = not(copies.get(1) == 2 and not(1.in(outbox)) and auditEffects.get(1) == 1)
}
