fn factorial(n) {
  case n {
    0 -> 1
    _ -> n * factorial(n - 1)
  }
}

pub fn main() -> Int {
  factorial(10)
}
