pub type Shape {
  Circle(radius: Int)
  Rectangle(width: Int, height: Int)
}

fn area(shape) {
  case shape {
    Circle(radius: r) -> 3 * r * r
    Rectangle(width: w, height: h) -> w * h
  }
}

fn larger(left, right) {
  case area(left) > area(right) {
    True -> left
    False -> right
  }
}

pub fn main() -> Shape {
  larger(Circle(radius: 3), Rectangle(width: 6, height: 7))
}
