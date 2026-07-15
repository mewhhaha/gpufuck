module ResultCombinators where {
data Result failure success = Failure failure | Success success;

mapResult :: (a -> b) -> Result failure a -> Result failure b;
mapResult function result =
    case result of {
        Failure failure -> Failure failure;
        Success value -> Success (function value)
    };

bindResult :: (a -> Result failure b) -> Result failure a -> Result failure b;
bindResult function result =
    case result of {
        Failure failure -> Failure failure;
        Success value -> function value
    };

foldResult :: (failure -> value) -> (success -> value) -> Result failure success -> value;
foldResult onFailure onSuccess result =
    case result of {
        Failure failure -> onFailure failure;
        Success success -> onSuccess success
    };

increment :: Int -> Int;
increment value = value + 1;

safeIncrement :: Int -> Result Int Int;
safeIncrement value = if value < 0 then Failure 7 else Success (value + 1);

failureValue :: Int -> Int;
failureValue failure = failure;

successValue :: Int -> Int;
successValue success = success;

gpuMain =
    let {
        mapped = foldResult failureValue successValue (mapResult increment (Success 41));
        bound = foldResult failureValue successValue (bindResult safeIncrement (Success 41));
        failed = foldResult failureValue successValue (bindResult safeIncrement (Failure 7))
    } in
        if mapped == 42 then
            if bound == 42 then
                if failed == 7 then 42 else 0
            else 0
        else 0
}
