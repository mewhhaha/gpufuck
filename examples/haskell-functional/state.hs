module StateFunctions where {
data State state value = State (state -> (value, state));

runState :: State state value -> state -> (value, state);
runState stateFunction initial =
    case stateFunction of { State run -> run initial };

mapStateStep transform run initial =
    case run initial of {
        (value, next) -> (transform value, next)
    };

mapState transform stateFunction =
    case stateFunction of {
        State run -> State (mapStateStep transform run)
    };

pureStateStep value stateValue = (value, stateValue);

pureState value = State (pureStateStep value);

bindStateStep function run initial =
    case run initial of {
        (value, next) ->
            case function value of {
                State continue -> continue next
            }
    };

bindState function stateFunction =
    case stateFunction of {
        State run -> State (bindStateStep function run)
    };

increment :: Int -> Int;
increment value = value + 1;

incrementStateStep :: Int -> (Int, Int);
incrementStateStep stateValue = (stateValue, stateValue + 1);

incrementState = State incrementStateStep;

finish value = pureState (value + 1);

gpuMain =
    case runState (mapState increment incrementState) 40 of {
        (mappedValue, mappedState) ->
            if mappedValue == 41 then
                if mappedState == 41 then
                    case runState (bindState finish incrementState) 41 of {
                        (boundValue, boundState) ->
                            if boundValue == 42 then
                                if boundState == 42 then boundValue else 0
                            else 0
                    }
                else 0
            else 0
    }
}
