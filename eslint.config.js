import tseslint from "@typescript-eslint/eslint-plugin";

export default [
    { ignores: ["dist/**", "node_modules/**"] },
    ...tseslint.configs["flat/recommended"].map((config) => ({ ...config, files: ["src/**/*.ts"] })),
    {
        files: ["src/**/*.ts"],
        rules: {
            // A leading underscore marks a parameter or binding that is unused on purpose (the
            // codebase's convention for fakes and for dropping a field while destructuring).
            "@typescript-eslint/no-unused-vars": [
                "error",
                { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
            ],
        },
    },
];
