// One Queue message. The caller models the handler's effect separately.
// Ack is intentionally unconditional: acknowledging before an effect is an
// application bug that the caller's invariant must detect.
module queueMessage {
  const MaxDeliveries: int
  assume PositiveLimit = MaxDeliveries > 0

  var pending: bool
  var inFlight: bool
  var acked: bool
  var deliveries: int

  action init = all {
    pending' = false,
    inFlight' = false,
    acked' = false,
    deliveries' = 0,
  }

  action send = all {
    deliveries == 0,
    pending == false,
    pending' = true,
    inFlight' = inFlight,
    acked' = acked,
    deliveries' = deliveries,
  }

  action deliver = all {
    pending,
    inFlight == false,
    deliveries < MaxDeliveries,
    inFlight' = true,
    deliveries' = deliveries + 1,
    pending' = pending,
    acked' = acked,
  }

  action ack = all {
    inFlight,
    pending' = false,
    inFlight' = false,
    acked' = true,
    deliveries' = deliveries,
  }

  action retry = all {
    inFlight,
    pending' = pending,
    inFlight' = false,
    acked' = acked,
    deliveries' = deliveries,
  }

  action hold = all {
    pending' = pending,
    inFlight' = inFlight,
    acked' = acked,
    deliveries' = deliveries,
  }

  val wellFormed = not(acked and pending) and not(acked and inFlight) and deliveries <= MaxDeliveries
}
