import { backoffDelay } from '../backoff';

describe('§5.4 retry backoff', () => {
    test('doubles from 1 s and caps at 30 s (no jitter at random = 0.5)', () => {
        const delays = [0, 1, 2, 3, 4, 5, 6, 20].map((attempt) =>
            backoffDelay(attempt, () => 0.5)
        );
        expect(delays).toEqual([
            1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
        ]);
    });

    test('jitter spreads a delay between half and one and a half steps', () => {
        expect(backoffDelay(1, () => 0)).toBe(1000);
        expect(backoffDelay(1, () => 0.999)).toBe(2998);
    });

    test('jitter never takes a delay above 30 s', () => {
        expect(backoffDelay(4, () => 0.999)).toBe(23984);
        expect(backoffDelay(5, () => 0.999)).toBe(30000);
        expect(backoffDelay(10, () => 0.999)).toBe(30000);
        expect(backoffDelay(10, () => 0)).toBe(15000);
    });
});
