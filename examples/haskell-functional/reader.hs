module ReaderFunctions where {
data Reader environment value = Reader (environment -> value);

runReader :: Reader environment value -> environment -> value;
runReader reader environment =
    case reader of { Reader run -> run environment };

mapReaderStep transform run environment = transform (run environment);

mapReader :: (a -> b) -> Reader environment a -> Reader environment b;
mapReader transform reader =
    case reader of { Reader run -> Reader (mapReaderStep transform run) };

askStep environment = environment;

ask = Reader askStep;

asks function = Reader function;

localStep transform run environment = run (transform environment);

local transform reader =
    case reader of { Reader run -> Reader (localStep transform run) };

increment :: Int -> Int;
increment value = value + 1;

double :: Int -> Int;
double value = value * 2;

gpuMain =
    let {
        mapped = runReader (mapReader increment ask) 41;
        localized = runReader (local increment (asks double)) 20
    } in
        if mapped == 42 then
            if localized == 42 then 42 else 0
        else 0
}
