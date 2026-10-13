import itertools
import time

from canonada.catalog import Datahandler


class Ticker(Datahandler):
    """
    A stream that never ends: yields 0, 1, 2, ... one value every `interval` seconds
    """

    def __init__(self, name: str, keys: set, kwargs: dict) -> None:
        super().__init__(name, "demo.ticker", keys, kwargs)
        self.interval = float(kwargs.get("interval", 1.0))

    def __len__(self) -> int:
        return 0  # Unknown length: Canonada's progress bar shows items and rate instead of a percentage

    def __iter__(self):
        for value in itertools.count():
            time.sleep(self.interval)
            yield value, value

    def __getitem__(self, key: int) -> int:
        return key

    def save(self, kwargs: dict) -> None:
        raise NotImplementedError("demo.ticker is read-only")
