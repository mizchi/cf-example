// One retained log, one atomic produce of events 1/2, two independent
// subscriptions, and two workers sharing the analytics subscription.
// Lease expiry does not stop an old worker's application side effects.
// The safe sink atomically deduplicates by stable event ID, not batch ID.
// No retention expiry, producer retry, partitions, or external sink I/O.
module k2 {
  import k2Subscription(MaxBatches = 2) as Analytics from "./lib/k2-subscription"
  import k2Subscription(MaxBatches = 2) as Audit from "./lib/k2-subscription"

  pure val Records = Set(1, 2)
  pure val Workers = Set(1, 2)

  var log: List[int]
  var localBatch: int -> int
  var handled: int -> Set[int]
  var processed: Set[int]
  var effects: int -> int
  var auditDone: bool
  var observation: int // 0: ordinary; 1: stale ack; 2: recovery; 3: extension

  action init = all {
    Analytics::init,
    Audit::init,
    log' = List(),
    localBatch' = Map(1 -> 0, 2 -> 0),
    handled' = Map(1 -> Set(), 2 -> Set()),
    processed' = Set(),
    effects' = Map(1 -> 0, 2 -> 0),
    auditDone' = false,
    observation' = 0,
  }

  action holdApplication = all {
    log' = log,
    localBatch' = localBatch,
    handled' = handled,
    processed' = processed,
    effects' = effects,
    auditDone' = auditDone,
  }

  // Successful produce atomically appends the whole batch. Ack never
  // removes these records; the other subscription can still consume them.
  action produce = all {
    log.length() == 0,
    Analytics::hold,
    Audit::hold,
    log' = List(1, 2),
    localBatch' = localBatch,
    handled' = handled,
    processed' = processed,
    effects' = effects,
    auditDone' = auditDone,
    observation' = 0,
  }

  action consume = {
    nondet worker = Workers.oneOf()
    all {
      log.length() == 2,
      localBatch.get(worker) == 0,
      Analytics::acquire(worker),
      Audit::hold,
      localBatch' = localBatch.set(worker, Analytics::batchId + 1),
      handled' = handled.set(worker, Set()),
      log' = log,
      processed' = processed,
      effects' = effects,
      auditDone' = auditDone,
      observation' = 0,
    }
  }

  action recover = {
    nondet worker = Workers.oneOf()
    all {
      localBatch.get(worker) > 0,
      localBatch.get(worker) == Analytics::batchId,
      Analytics::recover(worker),
      Audit::hold,
      holdApplication,
      observation' = 2,
    }
  }

  action extend = {
    nondet worker = Workers.oneOf()
    all {
      Analytics::extend(worker, localBatch.get(worker)),
      Audit::hold,
      holdApplication,
      observation' = 3,
    }
  }

  action tick = all {
    Analytics::tick,
    Audit::hold,
    holdApplication,
    observation' = 0,
  }

  action process(safe: bool): bool = {
    nondet worker = Workers.oneOf()
    nondet event = Records.oneOf()
    all {
      localBatch.get(worker) > 0,
      not(event.in(handled.get(worker))),
      Analytics::hold,
      Audit::hold,
      // A timed-out worker can still run. Only the sink's atomic event-ID
      // check prevents it and a new worker from applying the effect twice.
      effects' = if (safe and event.in(processed)) effects
        else effects.set(event, effects.get(event) + 1),
      processed' = processed.union(Set(event)),
      handled' = handled.set(worker, handled.get(worker).union(Set(event))),
      localBatch' = localBatch,
      log' = log,
      auditDone' = auditDone,
      observation' = 0,
    }
  }

  action processNaive = process(false)
  action processSafe = process(true)

  action nack = {
    nondet worker = Workers.oneOf()
    all {
      localBatch.get(worker) > 0,
      Analytics::nack(localBatch.get(worker)),
      Audit::hold,
      localBatch' = localBatch.set(worker, 0),
      handled' = handled,
      log' = log,
      processed' = processed,
      effects' = effects,
      auditDone' = auditDone,
      observation' = 0,
    }
  }

  action ack = {
    nondet worker = Workers.oneOf()
    all {
      localBatch.get(worker) > 0,
      handled.get(worker) == Records,
      Analytics::ack(localBatch.get(worker)),
      Audit::hold,
      localBatch' = localBatch.set(worker, 0),
      handled' = handled,
      log' = log,
      processed' = processed,
      effects' = effects,
      auditDone' = auditDone,
      observation' = if (localBatch.get(worker) != Analytics::batchId and Analytics::cursor == 0) 1 else 0,
    }
  }

  // Bug: acknowledge the entire batch after processing just one record.
  action ackEarly = {
    nondet worker = Workers.oneOf()
    all {
      localBatch.get(worker) > 0,
      handled.get(worker).size() == 1,
      Analytics::ack(localBatch.get(worker)),
      Audit::hold,
      localBatch' = localBatch.set(worker, 0),
      handled' = handled,
      log' = log,
      processed' = processed,
      effects' = effects,
      auditDone' = auditDone,
      observation' = 0,
    }
  }

  action consumeAudit = all {
    log.length() == 2,
    Analytics::hold,
    Audit::acquire(1),
    holdApplication,
    observation' = 0,
  }

  action finishAudit = all {
    Audit::holder == 1,
    Analytics::hold,
    Audit::ack(Audit::batchId),
    auditDone' = true,
    log' = log,
    localBatch' = localBatch,
    handled' = handled,
    processed' = processed,
    effects' = effects,
    observation' = 0,
  }

  // Keep expiry in the broken replay variant so TLC must expose it.
  action stepNaive = any { produce, consume, processNaive, tick, ack }
  action stepAckEarly = any { produce, consume, processSafe, ackEarly }
  action stepSafe = any { produce, consume, processSafe, tick, nack, ack, recover, extend, consumeAudit, finishAudit }

  val atMostOneEffect = Records.forall(event => effects.get(event) <= 1)
  val noAckBeforeEffects = Analytics::cursor == 0 or processed == Records
  val streamWellFormed = all {
    log == List() or log == List(1, 2),
    (Analytics::cursor == 0 and Audit::cursor == 0) or log.length() == 2,
    Analytics::wellFormed,
    Audit::wellFormed,
  }
  val subscriptionIsolation = Audit::cursor == 0 or auditDone
  val staleAckCannotAdvance = observation != 1 or Analytics::cursor == 0
  val recoveryKeepsBatch = observation != 2 or all {
    Analytics::remaining == 2,
    localBatch.get(Analytics::holder) == Analytics::batchId,
  }
  val extensionKeepsLease = observation != 3 or all {
    Analytics::remaining == 2,
    localBatch.get(Analytics::holder) == Analytics::batchId,
  }

  // Negated reachability checks: these must fail with positive witnesses.
  val noReplayCompleted = not(Analytics::batchId == 2 and Analytics::cursor == 2
    and Records.forall(event => effects.get(event) == 1))
  val noFanoutCompleted = not(Analytics::cursor == 2 and Audit::cursor == 2)
  val noStaleAckIgnored = observation != 1
  val noLeaseRecovery = observation != 2
  val noLeaseExtension = observation != 3
}
