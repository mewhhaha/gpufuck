enum Option<T> {
    None,
    Some(T),
}

fn increment(value: i32) -> i32 {
    value + 1
}

fn map<A, B>(function: fn(A) -> B, value: Option<A>) -> Option<B> {
    match value {
        Option::None => Option::None,
        Option::Some(inner) => Option::Some(function(inner)),
    }
}

fn gpu_main() -> i32 {
    match map(increment, Option::Some(41)) {
        Option::None => 0,
        Option::Some(value) => value,
    }
}

fn main() {}
