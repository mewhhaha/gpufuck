fn fold(values, accumulator, combine) {
  case values {
    [] -> accumulator
    [head, ..tail] -> fold(tail, combine(accumulator, head), combine)
  }
}

fn add(left, right) {
  left + right
}

pub fn main() -> Int {
  fold([10, 20, 12], 0, add)
}
