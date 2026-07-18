struct OwnedNumber {
    value: i32,
}

fn read(number: OwnedNumber) -> i32 {
    match number {
        OwnedNumber { value } => value,
    }
}

fn gpu_main() -> i32 {
    let number = OwnedNumber { value: 21 };
    let borrowed = read(&number);
    borrowed + read(number)
}

fn main() {}
