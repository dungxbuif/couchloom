export class AcknowledgedChangeStream {
    #tail: Promise<void> = Promise.resolve();
    #failure: unknown;
    checkpoint: string;

    constructor(initialCheckpoint: string) {
        this.checkpoint = initialCheckpoint;
    }

    enqueue(seq: string, apply: () => Promise<void>): Promise<void> {
        const task = this.#tail.then(async () => {
            if (this.#failure !== undefined) throw this.#failure;
            try {
                await apply();
                this.checkpoint = seq;
            } catch (error) {
                this.#failure = error;
                throw error;
            }
        });
        this.#tail = task.catch(() => undefined);
        return task;
    }

    async drain(): Promise<void> {
        await this.#tail;
        if (this.#failure !== undefined) throw this.#failure;
    }
}
