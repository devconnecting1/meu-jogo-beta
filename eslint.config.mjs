import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{ ignores: ["out/**", "node_modules/**", "include/**"] },
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		rules: {
			"no-undef": "off",
			"no-debugger": "off",
			"no-empty": ["error", { allowEmptyCatch: true }],
			"no-extra-boolean-cast": "off",
			"no-undef-init": "error",
			"no-constant-condition": ["error", { checkLoops: false }],
			"prefer-const": "off",
			curly: ["warn", "multi-line", "consistent"],
			"@typescript-eslint/array-type": [
				"warn",
				{
					default: "generic",
					readonly: "generic",
				},
			],
			"@typescript-eslint/no-unused-vars": "warn",
			"@typescript-eslint/no-empty-function": "off",
			"@typescript-eslint/no-namespace": "off",
			"@typescript-eslint/no-non-null-assertion": "off",
			"@typescript-eslint/no-use-before-define": "off",
			"@typescript-eslint/explicit-module-boundary-types": "off",
			"@typescript-eslint/no-require-imports": "error",
			"@typescript-eslint/no-unused-expressions": "warn",
		},
	},
);
