// A three-record batch: good 1, malformed 2, good 3. Two deliveries.
// Good effects and quarantine receipts persist; local preparation does not.
module poisonEvents {
  pure val Good = Set(1, 3)
  pure val Records = Set(1, 2, 3)
  var active: bool
  var deliveries: int
  var handled: Set[int]
  var processed: Set[int]
  var effects: int -> int
  var isolated: bool
  var quarantineCount: int
  var acked: bool
  var crashed: bool

  action init = all {
    active' = false, deliveries' = 0, handled' = Set(), processed' = Set(),
    effects' = Map(1 -> 0, 3 -> 0), isolated' = false,
    quarantineCount' = 0, acked' = false, crashed' = false,
  }
  action holdDurable = all { processed' = processed, effects' = effects,
    isolated' = isolated, quarantineCount' = quarantineCount, acked' = acked }
  action deliver = all {
    not(active), not(acked), deliveries < 2,
    active' = true, deliveries' = deliveries + 1, handled' = Set(),
    holdDurable, crashed' = crashed,
  }
  action processGood = {
    nondet event = Good.oneOf()
    all {
      active, not(event.in(handled)),
      processed' = processed.union(Set(event)),
      effects' = if (event.in(processed)) effects else effects.set(event, effects.get(event) + 1),
      handled' = handled.union(Set(event)), active' = active, deliveries' = deliveries,
      isolated' = isolated, quarantineCount' = quarantineCount,
      acked' = acked, crashed' = crashed,
    }
  }
  // Preparing an isolation record in memory is not a durable disposition.
  action prepareBad = all {
    active, not(2.in(handled)), handled' = handled.union(Set(2)),
    active' = active, deliveries' = deliveries, holdDurable, crashed' = crashed,
  }
  action persistBad = all {
    active, 2.in(handled),
    isolated' = true, quarantineCount' = if (isolated) quarantineCount else quarantineCount + 1,
    processed' = processed, effects' = effects, acked' = acked,
    active' = active, deliveries' = deliveries, handled' = handled, crashed' = crashed,
  }
  action crash = all {
    active, crashed == false,
    active' = false, handled' = Set(), crashed' = true,
    deliveries' = deliveries, holdDurable,
  }
  action ack(safe: bool): bool = all {
    active, handled == Records, (not(safe) or isolated),
    acked' = true, active' = false, handled' = handled, deliveries' = deliveries,
    processed' = processed, effects' = effects,
    isolated' = isolated, quarantineCount' = quarantineCount, crashed' = crashed,
  }
  action ackNaive = ack(false)
  action ackSafe = ack(true)
  action stepNaive = any { deliver, processGood, prepareBad, persistBad, crash, ackNaive }
  action stepSafe = any { deliver, processGood, prepareBad, persistBad, crash, ackSafe }
  val noAckBeforeDisposition = not(acked) or (processed == Good and isolated)
  val atMostOneDisposition = Good.forall(event => effects.get(event) <= 1) and quarantineCount <= 1
  val badRecordNeverApplied = not(2.in(processed))
  val noRecoveredBatch = not(crashed and deliveries == 2 and acked and isolated and processed == Good)
}
