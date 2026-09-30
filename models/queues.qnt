// One message with a stable job ID, at most two deliveries, and one effect.
// The safe effect and processed marker are one atomic operation at the sink.
module queues {
  import queueMessage(MaxDeliveries = 2) as Msg from "./lib/queue-message"
  import once as Effect from "./lib/once"

  var applied: bool
  var effectCount: int

  action init = all {
    Msg::init,
    Effect::init,
    applied' = false,
    effectCount' = 0,
  }

  action send = all {
    Msg::send,
    Effect::hold,
    applied' = applied,
    effectCount' = effectCount,
  }

  action deliver = all {
    Msg::deliver,
    Effect::hold,
    applied' = false,
    effectCount' = effectCount,
  }

  // Bug: each delivery applies the effect, including a redelivery.
  action applyNaive = all {
    Msg::inFlight,
    applied == false,
    Msg::hold,
    Effect::mark,
    effectCount' = effectCount + 1,
    applied' = true,
  }

  // Repair: the job ID is checked and recorded atomically with the effect.
  action applySafe = all {
    Msg::inFlight,
    applied == false,
    Msg::hold,
    Effect::reserve,
    effectCount' = effectCount + 1,
    applied' = true,
  }

  action skipDuplicate = all {
    Msg::inFlight,
    applied == false,
    Effect::done,
    Msg::hold,
    Effect::hold,
    applied' = true,
    effectCount' = effectCount,
  }

  // The consumer fails after the effect but before acknowledging the batch.
  action failAfterEffect = all {
    applied,
    Msg::retry,
    Effect::hold,
    applied' = applied,
    effectCount' = effectCount,
  }

  action ack = all {
    applied,
    Msg::ack,
    Effect::hold,
    applied' = applied,
    effectCount' = effectCount,
  }

  action stepNaive = any { send, deliver, applyNaive, failAfterEffect, ack }
  action stepSafe = any { send, deliver, applySafe, skipDuplicate, failAfterEffect, ack }

  val atMostOneEffect = effectCount <= 1
  val queueWellFormed = Msg::wellFormed
  // Negated reachability check: a retried message can still be acknowledged.
  val noRetryHandled = not(Msg::deliveries == 2 and Msg::pending == false and effectCount == 1)
}
