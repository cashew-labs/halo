"""Descriptor-based access to workspace paths owned by an unprivileged user."""
import contextlib
import os
import pathlib
import stat


def under(root, *parts):
    """A path below root built from request values; it can never leave root."""
    base = os.path.normpath(str(root))
    path = os.path.normpath(os.path.join(base, *parts))
    if not path.startswith(base + os.sep):
        raise ValueError('App path escapes its root')
    return pathlib.Path(path)


@contextlib.contextmanager
def directory(path):
    path = pathlib.Path(path)
    if not path.is_absolute():
        raise ValueError('App paths must be absolute')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    descriptor = os.open('/', flags)
    try:
        for component in path.parts[1:]:
            child = os.open(component, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        yield descriptor
    finally:
        os.close(descriptor)


@contextlib.contextmanager
def regular_file(path):
    path = pathlib.Path(path)
    with directory(path.parent) as parent:
        descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    with os.fdopen(descriptor, 'rb') as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise ValueError('App input must be a regular file')
        yield source
