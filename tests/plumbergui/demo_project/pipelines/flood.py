import logging

from canonada.pipeline import Node, Pipeline

log = logging.getLogger("canonada.demo")


def pour(megabytes: int) -> None:
    padding = "x" * 120
    target = int(megabytes) * 1024 * 1024
    written = 0
    line = 0
    while written < target:
        message = f"flood line {line} {padding}"
        log.info(message)
        written += len(message) + 45  # Plus the timestamp, logger, and level prefix
        line += 1


flood = Pipeline(
    "flood",
    [Node(func=pour, input=["params:flood.megabytes"], output=["_"], name="pour")],
    description="Writes about flood.megabytes MB of log lines. Start it by hand; the devstack check never does.",
)
