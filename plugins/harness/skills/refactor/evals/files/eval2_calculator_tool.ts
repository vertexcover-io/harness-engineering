export function createCalculatorTool(config: { precision: number }) {
  return {
    execute(expression: string): string {
      try {
        // Simple arithmetic parser (add, subtract, multiply, divide)
        const tokens = expression.match(/[\d.]+|[+\-*/]/g) || [];
        let result = parseFloat(tokens[0]);
        for (let i = 1; i < tokens.length; i += 2) {
          const op = tokens[i];
          const num = parseFloat(tokens[i + 1]);
          if (op === "+") result += num;
          else if (op === "-") result -= num;
          else if (op === "*") result *= num;
          else if (op === "/") result /= num;
        }
        return String(Number(result.toFixed(config.precision)));
      } catch (e) {
        return `Error: ${(e as Error).message}`;
      }
    },
    name: "calculator",
    about: "Evaluates mathematical expressions",
  };
}
