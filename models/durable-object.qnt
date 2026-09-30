// One Durable Object, two requests, one job. Phase 1 is an external await.
module durableObject {
  import once as Claim from "./lib/once"

  var phaseA: int // 0 new, 1 waiting for external I/O, 2 completed, 3 rejected
  var phaseB: int
  var accepted: int

  action init = all {
    Claim::init,
    phaseA' = 0,
    phaseB' = 0,
    accepted' = 0,
  }

  // Bug: both requests can observe pending before either awaits external I/O.
  action readA = all {
    phaseA == 0,
    Claim::done == false,
    Claim::hold,
    phaseA' = 1,
    phaseB' = phaseB,
    accepted' = accepted,
  }
  action readB = all {
    phaseB == 0,
    Claim::done == false,
    Claim::hold,
    phaseB' = 1,
    phaseA' = phaseA,
    accepted' = accepted,
  }

  // Repair: reserve in storage before awaiting external I/O.
  action reserveA = all {
    phaseA == 0,
    Claim::reserve,
    phaseA' = 1,
    phaseB' = phaseB,
    accepted' = accepted,
  }
  action reserveB = all {
    phaseB == 0,
    Claim::reserve,
    phaseB' = 1,
    phaseA' = phaseA,
    accepted' = accepted,
  }

  action rejectA = all {
    phaseA == 0,
    Claim::done,
    Claim::hold,
    phaseA' = 3,
    phaseB' = phaseB,
    accepted' = accepted,
  }
  action rejectB = all {
    phaseB == 0,
    Claim::done,
    Claim::hold,
    phaseB' = 3,
    phaseA' = phaseA,
    accepted' = accepted,
  }

  action finishA = all {
    phaseA == 1,
    Claim::mark,
    phaseA' = 2,
    phaseB' = phaseB,
    accepted' = accepted + 1,
  }
  action finishB = all {
    phaseB == 1,
    Claim::mark,
    phaseB' = 2,
    phaseA' = phaseA,
    accepted' = accepted + 1,
  }

  action stepNaive = any { readA, readB, finishA, finishB, rejectA, rejectB }
  action stepSafe = any { reserveA, reserveB, finishA, finishB, rejectA, rejectB }

  val atMostOneClaim = accepted <= 1
}
