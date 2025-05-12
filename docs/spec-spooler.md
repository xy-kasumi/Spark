# Spooler Spec

This doc specifies how Spooler should behave.

Spooler is a stateful server that exposes the machine to the dashboard web apps or potentially other programs.
Spooler is part of the Shell.

Spooler's purpose:
* Freeup dashboard dev from needing to care about realtime requirements of the machine.
* Freeup Core responsibility by handling data storage, sorting etc. in (single-board) PC environment.

Spooler needs to maintain semi-realtime (freeze of more than 1sec is not allowed) connection to the Core.

Spooler knows about grblHAL (or other Core protocol) and translates it to more friendly and universal form.
Spooler does NOT know about G-code semantics. It only knows about its semantics and grblHAL protocol.
But spooler does know about board & machine configuration (number of axes etc).

Main functionalities:
* Buffers big G-code and streams into the machine. Streaming state is controlled from the API.
* Gathers log from the machine and make it available via API
