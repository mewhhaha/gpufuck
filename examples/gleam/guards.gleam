fn classify(value) {
  case value {
    n if n < 0 -> "negative"
    0 -> "zero"
    n if n < 10 -> "small"
    _ -> "large"
  }
}

pub fn main() -> String {
  classify(-4) <> " " <> classify(0) <> " " <> classify(7) <> " " <> classify(99)
}
