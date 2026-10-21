export interface TrailingSingleFlight {
  request(): Promise<void>;
}

export function createTrailingSingleFlight(task: () => Promise<void>): TrailingSingleFlight {
  let active: Promise<void> | null = null;
  let requested = false;

  return {
    request(): Promise<void> {
      requested = true;
      if (active) {
        return active;
      }

      const execute = async (): Promise<void> => {
        while (requested) {
          requested = false;
          await task();
        }
      };
      const current = execute().finally(() => {
        if (active === current) {
          active = null;
        }
      });
      active = current;
      return current;
    }
  };
}
