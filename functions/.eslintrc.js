module.exports = {
  env: {
    es6: true,
    node: true,
  },
  parserOptions: {
    ecmaVersion: 2018, // Sin comillas para mantener consistencia
  },
  extends: [
    "eslint:recommended",
    "google",
  ],
  rules: {
    "no-restricted-globals": ["error", "name", "length"],
    // Revisa si estas restricciones son necesarias
    "prefer-arrow-callback": "error",
    "quotes": ["error", "double", {allowTemplateLiterals: true}],
  },
  overrides: [
    {
      files: ["**/*.spec.*"],
      env: {
        mocha: true,
      },
      rules: {
        // Puedes agregar reglas específicas aquí si es necesario
      },
    },
  ],
  globals: {}, // Agrega variables globales aquí si las necesitas
};
