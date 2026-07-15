fn factorial(value: i32) -> i32 {
    if value == 0 {
        1
    } else {
        value * factorial(value - 1)
    }
}

fn gpu_main() -> i32 {
    factorial(5)
}

fn main() {}
