export function serviceDefinitions(backend, specs) {
  return specs.map(([name, description, parameters]) => ({
    name,
    label: name,
    description: `${description} Returns JSON; Code Mode receives a parsed object. Services may return {error:{code:string,retryable:boolean}} instead; retry the identical arguments on retryable errors. Read calls are independent when their inputs are known. Responses are bounded below 10 KB.`,
    parameters,
    async execute(_id, args, signal) {
      const result = await backend.call(name, args, signal);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
    },
  }));
}
