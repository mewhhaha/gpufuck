fn choose(flag: bool, pair: (i32, i32)) -> i32 {
    if flag {
        match pair {
            (left, right) => left + right,
        }
    } else {
        0
    }
}

fn gpu_main() -> i32 {
    let pair = (20, 22);
    choose(true, pair)
}

fn main() {}
