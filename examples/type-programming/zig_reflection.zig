const std = @import("std");

fn WithGetter(comptime T: type) type {
    return struct {
        value: T,
        enabled: bool,

        pub fn get(self: @This()) T {
            return self.value;
        }
    };
}

fn reflectedFieldBytes(comptime T: type) usize {
    var total: usize = 0;
    inline for (std.meta.fields(T)) |field| {
        total += @sizeOf(field.type);
    }
    return total;
}

const WrappedI32 = WithGetter(i32);

test "comptime iterates fields and attaches a method" {
    try std.testing.expectEqual(@as(usize, 5), reflectedFieldBytes(WrappedI32));
    try std.testing.expect(@hasDecl(WrappedI32, "get"));
    try std.testing.expectEqual(@as(i32, 42), (WrappedI32{ .value = 42, .enabled = true }).get());
}
