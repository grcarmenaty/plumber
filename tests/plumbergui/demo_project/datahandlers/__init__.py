"""
Datahandlers of the demo project, registered in Canonada's catalog
"""

from canonada.catalog import available_datahandlers

from .ticker import Ticker

available_datahandlers.update({"demo.ticker": Ticker})
