import FindMyWay from "find-my-way";
import { z } from "zod";

const sampleRateSchema = z
  .number()
  .finite()
  .catch(1)
  .transform((rate) => Math.min(1, Math.max(0, rate)));

const samplingConfigSchema = z.object({
  rate: sampleRateSchema,
});

const logSampleRuleSchema = z.object({
  sample: samplingConfigSchema,
  skipBelowMs: z.number().int().min(0),
  sampleStatusAllowlist: z.array(z.number().int().nonnegative()),
});

const logSampleRuleInputSchema = z.object({
  path: z.string().min(1),
  sample: z
    .object({
      rate: sampleRateSchema.optional(),
    })
    .optional(),
  skipBelowMs: z.number().int().min(0).optional(),
  sampleStatusAllowlist: z.array(z.number().int().nonnegative()).optional(),
});

const logSampleRuleDefaultInputSchema = logSampleRuleInputSchema.omit({
  path: true,
});

export type SamplingConfig = z.infer<typeof samplingConfigSchema>;
export type LogSampleRule = z.infer<typeof logSampleRuleSchema>;
export type LogSampleRuleInput = z.input<typeof logSampleRuleInputSchema>;
export type LogSampleRuleDefaultInput = z.input<
  typeof logSampleRuleDefaultInputSchema
>;

export type LogSampleDecision = {
  shouldLog: boolean;
  rule: LogSampleRule;
};

const noopHandler = () => {};

function toLogSampleRule(
  input: z.infer<typeof logSampleRuleDefaultInputSchema>,
  defaultRule: LogSampleRule,
): LogSampleRule {
  return logSampleRuleSchema.parse({
    sample: {
      rate: input.sample?.rate ?? defaultRule.sample.rate,
    },
    skipBelowMs: input.skipBelowMs ?? defaultRule.skipBelowMs,
    sampleStatusAllowlist:
      input.sampleStatusAllowlist ?? defaultRule.sampleStatusAllowlist,
  });
}

export class LogSampleRules {
  private readonly matcher = FindMyWay();

  private readonly defaultRule: LogSampleRule;

  constructor(
    rules: readonly LogSampleRuleInput[],
    defaultInput: LogSampleRuleDefaultInput,
  ) {
    const parsedDefaultInput =
      logSampleRuleDefaultInputSchema.parse(defaultInput);

    this.defaultRule = toLogSampleRule(parsedDefaultInput, {
      sample: { rate: 1 },
      skipBelowMs: 0,
      sampleStatusAllowlist: [200, 201, 204],
    });

    for (const rule of rules) {
      const parsedRule = logSampleRuleInputSchema.parse(rule);

      this.matcher.on(
        "GET",
        parsedRule.path,
        noopHandler,
        toLogSampleRule(parsedRule, this.defaultRule),
      );
    }
  }

  get(path: string, status: number, latencyMs: number): LogSampleDecision {
    const resolvedRule = this.resolve(path);
    const canBeSampled = resolvedRule.sampleStatusAllowlist.includes(status);
    const shouldForceLog =
      !canBeSampled || latencyMs >= resolvedRule.skipBelowMs;

    if (shouldForceLog) {
      return {
        shouldLog: true,
        rule: resolvedRule,
      };
    }

    return {
      shouldLog: Math.random() <= resolvedRule.sample.rate,
      rule: resolvedRule,
    };
  }

  private resolve(path: string): LogSampleRule {
    const matched = this.matcher.find("GET", path);
    const parsedStore = logSampleRuleSchema.safeParse(matched?.store);

    if (parsedStore.success) {
      return parsedStore.data;
    }

    return this.defaultRule;
  }
}
