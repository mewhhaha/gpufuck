"!" @operator
"&" @operator
"&&" @operator
"(" @punctuation.bracket
")" @punctuation.bracket
"++" @operator
"," @punctuation.delimiter
"--" @operator
"." @punctuation.delimiter
"..." @operator
":" @punctuation.delimiter
"=>" @operator
"?" @operator
"[" @punctuation.bracket
"]" @punctuation.bracket
"^" @operator
"{" @punctuation.bracket
"|" @operator
"||" @operator
"}" @punctuation.bracket
"~" @operator
(async_function_declaration "async" @keyword)
(async_function_declaration "function" @keyword)
(await_expression "await" @keyword)
(break_statement "break" @keyword)
(catch_clause "catch" @keyword)
(class_declaration "class" @keyword)
(constant_declaration "const" @keyword)
(constant_for_initializer "const" @keyword)
(constant_statement "const" @keyword)
(continue_statement "continue" @keyword)
(else_clause "else" @keyword)
(exported_declaration "export" @keyword)
(finally_clause "finally" @keyword)
(for_statement "for" @keyword)
(function_declaration "function" @keyword)
(function_expression "function" @keyword)
(generator_declaration "function" @keyword)
(if_statement "if" @keyword)
(mutable_for_initializer "let" @keyword)
(mutable_statement "let" @keyword)
(new_expression "new" @keyword)
(return_statement "return" @keyword)
(throw_statement "throw" @keyword)
(try_statement "try" @keyword)
(typeof_expression "typeof" @keyword)
(var_for_initializer "var" @keyword)
(var_statement "var" @keyword)
(void_expression "void" @keyword)
(while_statement "while" @keyword)
(yield_statement "yield" @keyword)
(class_declaration) @type
(class_body) @type
(class_method) @type
(constant_declaration) @constant.builtin
(constant_statement) @constant.builtin
(constant_for_initializer) @constant.builtin
(boolean_not) @constant.builtin
(property_access) @variable.other.member
(object_property_list) @variable.other.member
(object_property_list_tail) @variable.other.member
(object_property) @variable.other.member
(named_object_property) @variable.other.member
(object_property_name) @variable.other.member
(identifier_property_name) @variable.other.member
(string_property_name) @string
(number_property_name) @number
(shorthand_object_property) @variable.other.member
(number_expression) @number
(string_expression) @string
(boolean_expression) @constant.builtin
(null_expression) @constant.builtin
(NUMBER) @number
(STRING) @string
(LINE_COMMENT) @comment
(BLOCK_COMMENT) @comment
(arrow_function parameter: (IDENT) @variable)
(async_function_declaration name: (IDENT) @function)
(catch_binding name: (IDENT) @variable)
(class_declaration name: (IDENT) @type)
(class_method name: (IDENT) @function)
(default_parameter name: (IDENT) @variable)
(function_declaration name: (IDENT) @function)
(function_expression name: (IDENT) @function)
(named_object_property name: (object_property_name) @variable.other.member)
(named_parameter name: (IDENT) @variable)
(object_binding_alias name: (IDENT) @variable)
(object_binding property: (IDENT) @variable.other.member)
(object_method name: (object_property_name) @function)
(property_access name: (IDENT) @variable.other.member)
(rest_parameter name: (IDENT) @variable)
(shorthand_object_property name: (IDENT) @variable.other.member)
(variable_declarator name: (IDENT) @variable)
