"""Shared process/container operations and comparison arm identity."""
import json
import subprocess

ARMS = ('pi-direct', 'pi-code', 'native')
LABELS = dict(zip(ARMS, ('Pi without Code Mode', 'Pi with Code Mode', 'native Codex'), strict=True))


def command(args, **kwargs):
    return subprocess.check_output([str(x) for x in args], text=True, **kwargs).strip()


def docker(*args, **kwargs):
    return subprocess.run(['docker', *map(str, args)], check=True, **kwargs)


def image_info(tag):
    image = json.loads(command(['docker', 'image', 'inspect', tag]))[0]
    if image['Architecture'] != 'amd64': raise ValueError('expected amd64 image')
    return {'image_id':image['Id'], 'digests':image.get('RepoDigests', []), 'architecture':image['Architecture']}


def pin_tag(image):
    tag = 'clanker-pi-evals:oc-' + image.split(':')[-1]
    docker('tag', image, tag)
    return tag
