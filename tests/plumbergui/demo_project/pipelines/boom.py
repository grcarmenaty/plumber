import logging

from canonada.pipeline import Node, Pipeline

log = logging.getLogger("canonada.demo")


def explode(lines: int) -> None:
    log.info("boom: about to fail")
    raise RuntimeError("boom: this pipeline always fails")


boom = Pipeline(
    "boom",
    [Node(func=explode, input=["params:chatty.lines"], output=["_"], name="explode")],
    description="Always fails, so its run ends as errored.",
    error_tolerant=False,
)
