struct Point {
    x: i32,
    y: i32,
}

fn sum(point: Point) -> i32 {
    match point {
        Point { x, y } => x * 100 + y,
    }
}

fn gpu_main() -> i32 {
    sum(Point { y: 22, x: 20 })
}

fn main() {}
