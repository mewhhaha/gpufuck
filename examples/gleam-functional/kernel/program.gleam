import kernel/math

pub fn run(state: Int, remaining: Int) -> Int {
  case remaining {
    0 -> state
    _ -> run(math.mix(state, remaining % 7 + 1), remaining - 1)
  }
}
