# AI extracts facts; deterministic rules decide Priority and Team

The AI produces only a Classification (Category, Summary, blocks-work, Impact Scope, Reason). Priority is computed by named Priority Rules over those facts, and Team is a fixed lookup from Category. We rejected letting the model suggest a priority and team that rules then "override", because that creates two sources of truth and makes a Ticket's Priority hard to explain. With this split, every Priority can be traced to the rules that fired, and the model cannot route work anywhere outside the predefined set.
