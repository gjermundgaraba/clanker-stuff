/**
 * @param {ReturnType<typeof import("../suites/scaling/services.mjs").createServices>} backend
 * @param {import("../suites/scaling/services.mjs").ToolSpec[]} specs
 */
export function serviceDefinitions(backend, specs) {
  return specs.map(([name, description, parameters]) => ({
    name,
    label: name,
    description: `${description} Returns JSON; Code Mode receives a parsed object. Services may return {error:{code:string,retryable:boolean}} instead; retry the identical arguments on retryable errors. Read calls are independent when their inputs are known. Responses are bounded below 10 KB.`,
    parameters,
    /**
     * @param {string} _id
     * @param {unknown} args Each public service call validates its own request contract.
     * @param {AbortSignal} [signal]
     * @returns {Promise<{content: {type: "text", text: string}[], details: object}>}
     */
    async execute(_id, args, signal) {
      const result = await backend.call(name, args, signal);

      return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
    },
  }));
}
