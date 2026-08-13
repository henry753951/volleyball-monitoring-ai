import { afterEach, describe, expect, it, vi } from "vitest";
import { useCoalescedFrameNavigation } from "./useCoalescedFrameNavigation";

function deferred<T>() {
   let resolve!: (value: T) => void;
   const promise = new Promise<T>((done) => {
      resolve = done;
   });
   return { promise, resolve };
}

afterEach(() => {
   vi.useRealTimers();
});

describe("useCoalescedFrameNavigation", () => {
   it("coalesces rapid taps into one authoritative request", async () => {
      vi.useFakeTimers();
      const step = vi.fn().mockResolvedValue("anchor");
      const apply = vi.fn();
      const navigation = useCoalescedFrameNavigation({
         preview: vi.fn(),
         step,
         apply,
         settleMs: 120,
      });

      navigation.enqueue("next");
      await vi.advanceTimersByTimeAsync(60);
      navigation.enqueue("next");
      await vi.advanceTimersByTimeAsync(60);
      navigation.enqueue("next", 5);
      await vi.advanceTimersByTimeAsync(120);

      expect(step).toHaveBeenCalledTimes(1);
      expect(step).toHaveBeenCalledWith("next", 7);
      expect(apply).toHaveBeenCalledWith("anchor", "next");
      navigation.stop();
   });

   it("never requests while a keyboard direction remains held", async () => {
      vi.useFakeTimers();
      const step = vi.fn().mockResolvedValue("anchor");
      const navigation = useCoalescedFrameNavigation({
         preview: vi.fn(),
         step,
         apply: vi.fn(),
         settleMs: 100,
         holdWatchdogMs: 500,
      });

      navigation.enqueue("next", 1, "keyboard");
      for (let index = 0; index < 8; index += 1) {
         await vi.advanceTimersByTimeAsync(80);
         navigation.enqueue("next", 1, "keyboard");
      }
      expect(step).not.toHaveBeenCalled();

      navigation.release("next");
      await vi.advanceTimersByTimeAsync(100);
      expect(step).toHaveBeenCalledTimes(1);
      expect(step).toHaveBeenCalledWith("next", 9);
      navigation.stop();
   });

   it("does not apply an older response after newer local input", async () => {
      vi.useFakeTimers();
      const first = deferred<string | null>();
      const step = vi
         .fn()
         .mockReturnValueOnce(first.promise)
         .mockResolvedValueOnce("new");
      const apply = vi.fn();
      const navigation = useCoalescedFrameNavigation({
         preview: vi.fn(),
         step,
         apply,
         settleMs: 50,
      });

      navigation.enqueue("next");
      await vi.advanceTimersByTimeAsync(50);
      navigation.enqueue("next", 5);
      first.resolve("old");
      await first.promise;
      await vi.runAllTimersAsync();

      expect(step).toHaveBeenCalledTimes(2);
      expect(apply).toHaveBeenCalledTimes(1);
      expect(apply).toHaveBeenCalledWith("new", "next");
      navigation.stop();
   });

   it("cancels opposite input without issuing a zero-delta request", async () => {
      vi.useFakeTimers();
      const step = vi.fn().mockResolvedValue("anchor");
      const navigation = useCoalescedFrameNavigation({
         preview: vi.fn(),
         step,
         apply: vi.fn(),
         settleMs: 80,
      });

      navigation.enqueue("next", 5);
      navigation.enqueue("previous", 5);
      await vi.advanceTimersByTimeAsync(80);

      expect(step).not.toHaveBeenCalled();
      navigation.stop();
   });
});
