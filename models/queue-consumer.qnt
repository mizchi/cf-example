// One push Consumer, two messages in its first batch, and one retry delivery.
// A succeeds; B fails once. A successful handler return implicitly acks
// every message without an explicit ack() or retry() decision.
module queueConsumer {
  import queueMessage(MaxDeliveries = 2) as A from "./lib/queue-message"
  import queueMessage(MaxDeliveries = 2) as B from "./lib/queue-message"

  var active: int // 0: idle, 1: first batch, 2: retry of B
  var effectA: bool
  var effectB: bool
  var failedB: bool
  var retryB: bool

  action init = all {
    A::init,
    B::init,
    active' = 0,
    effectA' = false,
    effectB' = false,
    failedB' = false,
    retryB' = false,
  }

  action sendBatch = all {
    A::send,
    B::send,
    active' = active,
    effectA' = effectA,
    effectB' = effectB,
    failedB' = failedB,
    retryB' = retryB,
  }

  action deliverBatch = all {
    active == 0,
    A::deliver,
    B::deliver,
    active' = 1,
    effectA' = effectA,
    effectB' = effectB,
    failedB' = failedB,
    retryB' = retryB,
  }

  action processA = all {
    active == 1,
    effectA == false,
    A::hold,
    B::hold,
    effectA' = true,
    active' = active,
    effectB' = effectB,
    failedB' = failedB,
    retryB' = retryB,
  }

  action failB = all {
    active == 1,
    effectA,
    failedB == false,
    A::hold,
    B::hold,
    failedB' = true,
    active' = active,
    effectA' = effectA,
    effectB' = effectB,
    retryB' = retryB,
  }

  // Bug: catch B's error and return normally; the runtime implicitly acks both.
  action catchAndReturnNaive = all {
    active == 1,
    failedB,
    effectB == false,
    A::ack,
    B::ack,
    active' = 0,
    effectA' = effectA,
    effectB' = effectB,
    failedB' = failedB,
    retryB' = retryB,
  }

  // Repair: decide each message explicitly before the handler returns.
  action ackA = all {
    active == 1,
    effectA,
    A::ack,
    B::hold,
    active' = active,
    effectA' = effectA,
    effectB' = effectB,
    failedB' = failedB,
    retryB' = retryB,
  }

  action retryFailedB = all {
    active == 1,
    failedB,
    A::acked,
    retryB == false,
    A::hold,
    B::retry,
    retryB' = true,
    active' = active,
    effectA' = effectA,
    effectB' = effectB,
    failedB' = failedB,
  }

  action returnFirst = all {
    active == 1,
    retryB,
    A::hold,
    B::hold,
    active' = 0,
    effectA' = effectA,
    effectB' = effectB,
    failedB' = failedB,
    retryB' = retryB,
  }

  action deliverRetry = all {
    active == 0,
    A::pending == false,
    B::pending,
    B::deliveries == 1,
    A::hold,
    B::deliver,
    active' = 2,
    effectA' = effectA,
    effectB' = effectB,
    failedB' = failedB,
    retryB' = retryB,
  }

  action processB = all {
    active == 2,
    effectB == false,
    A::hold,
    B::hold,
    effectB' = true,
    active' = active,
    effectA' = effectA,
    failedB' = failedB,
    retryB' = retryB,
  }

  action ackB = all {
    active == 2,
    effectB,
    A::hold,
    B::ack,
    active' = active,
    effectA' = effectA,
    effectB' = effectB,
    failedB' = failedB,
    retryB' = retryB,
  }

  action returnRetry = all {
    active == 2,
    B::acked,
    A::hold,
    B::hold,
    active' = 0,
    effectA' = effectA,
    effectB' = effectB,
    failedB' = failedB,
    retryB' = retryB,
  }

  action stepNaive = any { sendBatch, deliverBatch, processA, failB, catchAndReturnNaive }
  action stepSafe = any { sendBatch, deliverBatch, processA, failB, ackA, retryFailedB, returnFirst, deliverRetry, processB, ackB, returnRetry }

  val noAckBeforeEffect = (not(A::acked) or effectA) and (not(B::acked) or effectB)
  val noLostB = effectB or B::pending or B::deliveries == 0
  val queueWellFormed = A::wellFormed and B::wellFormed
  // Negated reachability check: both messages can finish after B's retry.
  val noCompletedBatch = not(A::acked and B::acked and effectA and effectB and active == 0)
}
