pub type Option(a) {
  None
  Some(a)
}

fn map(option, transform) {
  case option {
    None -> None
    Some(value) -> Some(transform(value))
  }
}

pub fn main() -> Int {
  case map(Some(21), fn(value) { value * 2 }) {
    None -> 0
    Some(value) -> value
  }
}
