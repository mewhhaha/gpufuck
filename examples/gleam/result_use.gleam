// `Result`, `Ok` and `Error` come from the prelude, so there is nothing to declare.
fn try(result, next) {
  case result {
    Error(reason) -> Error(reason)
    Ok(value) -> next(value)
  }
}

fn divide(numerator, denominator) {
  case denominator {
    0 -> Error("divide by zero")
    _ -> Ok(numerator / denominator)
  }
}

// `use` is Gleam's callback sugar: each line binds the value the previous step
// produced, and any Error short-circuits the rest of the function.
fn average(total, count, parts) {
  use mean <- try(divide(total, count))
  use share <- try(divide(mean, parts))
  Ok(share)
}

pub fn main() -> Result(Int, String) {
  average(840, 10, 2)
}
