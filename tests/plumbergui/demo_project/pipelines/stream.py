import logging

import datahandlers  # noqa: F401  Registers the demo.ticker datahandler
from canonada.pipeline import Node, Pipeline

log = logging.getLogger("canonada.demo")


def tick(value: int) -> None:
    if value % 20 == 19:
        raise ValueError(f"sensor glitch at item {value}")
    if value % 7 == 6:
        log.warning(f"item {value}: reading drifting")
    else:
        log.info(f"item {value}: ok")


stream = Pipeline(
    "stream",
    [Node(func=tick, input=["ticks"], output=["_"], name="tick")],
    description="Never ends. Reads the ticks stream; a WARNING every 7th item and an error with a traceback every 20th.",
    max_workers=1,
    error_tolerant=True,
)
