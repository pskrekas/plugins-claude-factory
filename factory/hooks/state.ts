// Names shared by the hooks files. The $.state atom itself is declared in each
// file that reads or writes it: the engine's scan must see the reference as a
// const of the file where `read` or `update` is called.
export const PANE = 'factory'
export const TITLE = 'Factory'
export const SHAPE = 'panel-2'
