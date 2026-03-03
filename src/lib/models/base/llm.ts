import z from 'zod';
import {
  GenerateObjectInput,
  GenerateOptions,
  GenerateTextInput,
  GenerateTextOutput,
  GenerateVisionTextInput,
  StreamTextOutput,
} from '../types';

abstract class BaseLLM<CONFIG> {
  constructor(protected config: CONFIG) {}
  abstract generateText(input: GenerateTextInput): Promise<GenerateTextOutput>;
  abstract streamText(
    input: GenerateTextInput,
  ): AsyncGenerator<StreamTextOutput>;
  abstract generateObject<T>(input: GenerateObjectInput): Promise<z.infer<T>>;
  abstract streamObject<T>(
    input: GenerateObjectInput,
  ): AsyncGenerator<Partial<z.infer<T>>>;

  supportsVision() {
    return false;
  }

  async generateVisionText(
    _input: GenerateVisionTextInput,
  ): Promise<GenerateTextOutput> {
    throw new Error('Vision inputs are not supported by this model');
  }
}

export default BaseLLM;
