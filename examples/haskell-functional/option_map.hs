module OptionMap where {
data Option a = None | Some a;

increment :: Int -> Int;
increment value = value + 1;

mapOption function option =
    case option of {
        None -> None;
        Some inner -> Some (function inner)
    };

gpuMain =
    case mapOption increment (Some 41) of {
        None -> 0;
        Some value -> value
    }
}
