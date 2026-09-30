// A one-time marker. Reserve checks the marker before setting it; mark does
// an unconditional write, which lets callers model a broken check-then-act.
module once {
  var done: bool

  action init = done' = false
  action hold = done' = done
  action mark = done' = true
  action reserve = all {
    done == false,
    done' = true,
  }
}
